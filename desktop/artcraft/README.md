# ArtCraft local workspace for Unified Studio

This embeds the original ArtCraft PageDraw and Stage3D components with local storage and local asset adapters. The source is pinned to `d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373` from [storytold/artcraft](https://github.com/storytold/artcraft/commit/d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373), under MIT or Apache-2.0. It is an adapted source build, not the official v0.41.0 binary release.

The included workspace supports layered canvas drawing, masks, shapes, undo, image composition, local background removal, 3D objects and lights, cameras, character pose controls, GLB import, native timeline controls, scene capture to a canvas layer, PNG output, and portable `.artcraft` projects containing both workspaces and imported assets. Local Save uses IndexedDB in the Unified Studio profile; Export project produces the portable file. The original geometric mannequin and synthetic image fixture were created for this integration.

Cloud generation, paid providers, accounts, cloud asset libraries, and mesh/world generation are unavailable in this workspace. It cannot issue paid requests. AI Studio is a separate host workspace with its own supported prompt/reference inputs and per-request paid confirmation. Private ArtCraft backend services are not included. Import accepts self-contained GLB and raster images; external-resource glTF, SPZ and video imports are not advertised in this build. Native timeline controls are retained; the smoke suite does not certify every animation/export format.

## Contents and licensing

- `upstream/`: pristine frontend source and root licenses from the pinned commit, with the public-resource allow-list applied.
- `src/`, `patches/`, `build.py`, `generate-mannequin.mjs`: local adapter and reproducible overlay.
- `upstream-local.patch`: generated changes to upstream renderer code.
- `assets/mannequin.glb`: original 19-bone geometric mannequin; generator source is included.
- `fixtures/original-figure.png`: original synthetic figure used for local background-removal verification.
- `notices/`: exact upstream licenses and NOTICE, supplemental asset licenses, and collected dependency notices.
- `omitted-upstream-assets.json`: exact upstream public files omitted from redistribution.
- `provenance.json`, `source-files.json`: source identity and file hashes.

The upstream NOTICE excludes Nintendo sounds, meme images, certain skyboxes, Lumine motion data, and character-animation GIFs from its software license. None of those files is included. Only shapes, fonts, placeholders, service-identification images and the licensed ammo runtime are retained from upstream public resources. Other unused upstream assets and ArtCraft logos are omitted. Service names/logos identify their respective services; trademark rights are not granted. The ArtCraft name identifies the adapted upstream components and does not imply endorsement. The old fair-source release ZIP and its LICENSE.md are not included in this package or used as the source of the shipped renderer.

Local original files and assets are under `LICENSE-LOCAL`; changes to upstream components may also be used under the upstream MIT/Apache terms. The complete Unified Studio distribution has its own combined distribution license. Local background-removal model/runtime notices live in the host `integrations/background` directory.

## Rebuilding

Requires Python 3, Node.js 22 or newer, npm, and network access for the initial free npm dependency download. From this directory run:

```powershell
python build.py --install --build
```

The script copies the included clean source into a separate build tree, installs the pinned package-lock with lifecycle scripts disabled, applies the local overlay, copies the permitted runtime assets, and produces `renderer/`. A subsequent `python build.py --build` reuses installed dependencies. `ARTCRAFT_BUILD_DIR` selects the scratch root; `ARTCRAFT_WORKTREE` selects the copied source tree. Neither may be inside `upstream/`. No official release ZIP or remote backend is needed. The canonical `upstream/` tree remains unchanged.

The generated mannequin is included so normal builds need no generation step. To regenerate it after installing dependencies, set `ARTCRAFT_FRONTEND` to the build tree's `frontend` directory and run `node generate-mannequin.mjs`; this writes `assets/mannequin.glb`. Three.js assigns fresh internal UUIDs, so a regenerated GLB may differ bytewise while retaining the same geometry and skeleton.

## Host contract and verification

The host serves `renderer/` at `studio://artcraft/index.html` with network access blocked, and exposes only `artcraftHost.removeBackground(rawBase64)` for the bundled local image worker. File opening calls `window.unifiedArtcraft.importFile(File)` and receives a serializable result. PNG and project downloads use the host export handler. Projects and imports have a 256 MB limit, including aggregate embedded assets; background removal has the host's 32 MB image limit.

`smoke.cjs` exports `run({contents,testDir})` for the host Electron verification harness. It opens the real UI, draws shapes and a mask, checks undo/redo and PNG output, removes a background through the visible local control, checks transparency and preserved transforms, enters original pose mode, changes bones/camera, imports a GLB and image plane, saves/reopens all scene and canvas state, and captures a scene into a canvas layer. The host additionally checks global `.artcraft` and `.glb` opening. Screenshots and JSON results are written only to `testDir`; user profiles are not packaged.

Tests use an original synthetic figure. A passing transparency check establishes that the bundled model ran locally; it is not a quality guarantee for every photograph. REA shipped-artifact inspection is separate from the Electron execution tests, and its static dependency graph does not prove all runtime paths.
