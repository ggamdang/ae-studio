# AE Studio Mac source

This folder retains the build layout: `desktop/` contains the AE Studio application and `macos/` contains packaging, dependency hashes and integration tests. `.github/workflows/macos.yml` records the CI build sequence. Bundled third-party source archives and their notices are alongside these directories.

To rebuild, copy this entire Source folder to a writable development folder on an Apple-silicon Mac running macOS 15 or newer. Install Python 3.12 or newer, Node.js 24 with npm, and Apple's free Command Line Tools. Start in that copied folder and follow the workflow's commands in order. Downloads are verified against the checked-in manifests; the final package and verification reports go into `dist/`.

The final installation test uses administrator privileges to install into `/Applications/AE Studio`. Use a disposable test Mac or runner: the script refuses to replace an existing AE Studio installation. It does not change default file handlers. Publisher signing and notarization are not part of this build.

The build fetches pinned native Craft releases, open-source runtimes and model assets. Account credentials and Google desktop registration are deliberately absent. Never commit personal tokens, passwords or registration secrets when sharing modifications. No paid AI requests are part of the build or tests.

AE Studio's license is in `desktop/LICENSE`. Third-party licenses remain applicable to their respective components. Source history is at https://github.com/ggamdang/ae-studio/tree/mac-port; consult the installer verification record for the exact build commit.
