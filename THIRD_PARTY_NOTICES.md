# Third-party notices

This file lists the third-party software and assets that `novaciel-core` uses and the conditions that come with them. Licenses were read from the installed packages (`node_modules`, versions pinned in `package-lock.json`) on 2026-10-22. It is a record for the developers, not legal advice; the items marked **to confirm** need a decision or a check before production use.

## Items that carry conditions

| Component | Version | License | What it means for us |
| --- | --- | --- | --- |
| Remotion (`remotion`, `@remotion/renderer`, `@remotion/bundler`) | 4.0.537 (pinned 4.0.x) | Remotion License (`LICENSE.md` inside each package; the packages declare `SEE LICENSE IN LICENSE.md`, not an SPDX id) | Free for an individual, a for-profit organization with up to 3 employees, a non-profit, or evaluation. Larger organizations need the company license (paid). NovaCiel declares the free plan (`REMOTION_LICENCIA=gratuita`), no `licenseKey`, nothing is sent to Remotion. **To confirm:** whether the freelance developer counts as a person of NovaCiel (3 or 4), before production use; whether running Remotion on our server for clients' videos is covered if the system is ever sold or licensed to other companies. The license changes in Remotion 5.0, so we stay on 4.0.x. Full analysis: [`docs/ADR-06_REMOTION_LICENCIA.md`](docs/ADR-06_REMOTION_LICENCIA.md). |
| Inter (Latin 400 and 700, `assets/fonts/`) | from `@fontsource/inter` 5.3.0 | SIL Open Font License 1.1 | May be bundled and redistributed with software; the license text travels with the font (`assets/fonts/OFL.txt`); the font is not sold by itself; do not modify the files or use the reserved name for a modified font. Source and hashes: `assets/fonts/README.md`. |
| sharp and libvips | sharp 0.35.5 | sharp: Apache-2.0. Prebuilt libvips binaries shipped with it (`@img/sharp-*`): `Apache-2.0 AND LGPL-3.0-or-later` | libvips is LGPL and is used as a dynamically loaded library, unmodified. If the system is ever distributed to others, keep the LGPL notice and let the recipient replace the library. Hosting it as a service for NovaCiel does not distribute it. |
| `@napi-rs/canvas` | 1.0.11 | MIT | Ships a native build with the Skia graphics library inside; keep its notices if the dependency tree is redistributed. **To confirm:** the license text of the bundled native binary at the time of any redistribution. |
| FFmpeg and ffprobe | system install, not bundled | LGPL or GPL depending on the build the operator installs | We call the executables as separate processes and do not ship them. The operator's build must include `zscale` and `tonemap`; check its license terms if the system is ever distributed together with FFmpeg. |
| Chrome Headless Shell | pinned by Remotion; downloaded at setup (`npm run remotion:browser`) | Chromium licenses (mainly BSD-3-Clause plus bundled third-party licenses) | Downloaded into `node_modules/.remotion/`, never committed, never downloaded at render time. **To confirm:** the license files that come inside the download, if the system is ever packaged with it. |

## Other direct dependencies

| Package | Version | License |
| --- | --- | --- |
| react, react-dom | 19.3.1 | MIT |
| fastify | 5.12.7 | MIT |
| @fastify/cookie, @fastify/multipart | 11.1.3, 10.1.3 | MIT |
| pg | 8.23.1 | MIT |
| pg-boss | 12.37.0 | MIT |
| node-pg-migrate | 9.0.0 | MIT |
| pino | 10.4.0 | MIT |
| zod | 4.6.5 | MIT |
| @anthropic-ai/sdk | 0.131.0 | MIT |
| @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | 3.1147.0 | Apache-2.0 |
| dotenv | 18.0.6 | BSD-2-Clause |
| typescript (dev) | 7.0.2 | Apache-2.0 |
| tsx (dev) | 4.23.15 | MIT |
| vitest (dev) | 5.0.3 | MIT |

Transitive dependencies are not listed one by one. To list them: `npx license-checker --production --summary` (run it with `npx`; it is not a dependency of this project).

## Services

Claude (Anthropic API) is used through the `LLMProvider` adapter under Anthropic's commercial terms and the system's own API key; no Anthropic software is bundled besides the MIT-licensed SDK above.
