# Icons for the diagrams and the documentation

They are used in the SVGs of [`../../diagrams`](../../diagrams/README.md), in the [README](../../../README.md) and in some
guides. They are not used in the application.

## `aws/`: AWS Architecture Icons

Source: the official *AWS Architecture Icons* package (`Asset-Package_07312025`). They are copied unmodified.

| File | Type | Official name |
|---|---|---|
| `ec2`, `s3`, `sqs`, `cognito`, `kms`, `iam`, `ecr`, `systems-manager`, `bedrock`, `textract` | Service (64 px) | `Arch_*_64.svg` |
| `group-aws-cloud`, `group-region`, `group-vpc`, `group-public-subnet` | Group (32 px) | `Architecture-Group-Icons` |
| `elastic-ip`, `users`, `documents`, `server` | Resource (48 px) | `Resource-Icons` |
| `users-dark`, `documents-dark`, `server-dark` | Resource for dark backgrounds | `Res_*_48_Dark` |

Terms of use: those of the AWS package. They serve to represent AWS services in architecture diagrams, without implying
AWS sponsorship or endorsement, and must not be altered or recolored. Check the
[AWS architecture icon guidelines](https://aws.amazon.com/architecture/icons/) before publishing outside this
repository. To add another icon, take it from the same package.

## `tech/`: technology logos

Source: [svgl.app](https://svgl.app), an open catalog of SVG logos. Each logo is a trademark of its owner. The
`*-dark.svg` variants are used in the dark diagrams.

| File | Brand |
|---|---|
| `typescript`, `node-js`, `fastify`, `next-js` | API and web |
| `python`, `fastapi` | Python services |
| `postgresql`, `docker`, `terraform` | Data and infrastructure |
| `ollama` | Local models |
| `gmail`, `slack`, `clickup` | Connectors |

## `ragis/`: content and pipeline glyphs

Drawn for this repository (24 px grid, stroke icons). Each one has a light and a `-dark` variant with the same hue,
matching the modality palette in [`../../diagrams/lib.py`](../../diagrams/lib.py) (`MODALITIES`).

| File | Meaning | Hue |
|---|---|---|
| `text` | Text chunk | orange |
| `figure` | Figure or image | blue |
| `equation` | Equation | violet |
| `table` | Table | green |
| `audio` | Recording transcript | pink |
| `graph` | Knowledge graph | sky |
| `vector` | Vector index | indigo |
| `llm` | Language model | amber |
| `search` | Retrieval | neutral |
| `verify` | Permission check or citation verifier | green |

## Brand: `../brand/`

`ragis-logo.svg` (for light backgrounds) and `ragis-logo-dark.svg` (for dark backgrounds) are the app mark from
`apps/web/app/icon.svg` with a fixed fill. The README shows them with `<picture>`.

## Root attributes

Some logos set `fill` or `stroke` on their root `<svg>` (Docker's blue, `fill="none"` in Python and Ollama).
`lib.py` keeps those attributes on a wrapper `<g>` when it embeds an icon; without that, the shapes turn black.

## How to add an icon

1. Copy the SVG to `aws/`, `tech/` or `ragis/` with a lowercase, hyphenated name. For svgl, download it from
   `https://svgl.app/library/<name>.svg` (the API `https://api.svgl.app?search=<text>` lists the names).
2. Check that it contains no `<script>`, `on*` attributes or external references.
3. Use it in `docs/diagrams/build.py` (`"tech/name.svg"`) and run `make diagrams`.
4. Animated logos (for example Floci's) do not work: they look incomplete as a static image.
