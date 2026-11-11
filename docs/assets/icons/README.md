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

## How to add an icon

1. Copy the SVG to `aws/` or `tech/` with a lowercase, hyphenated name. For svgl, download it from
   `https://svgl.app/library/<name>.svg` (the API `https://api.svgl.app?search=<text>` lists the names).
2. Check that it contains no `<script>`, `on*` attributes or external references.
3. Use it in `docs/diagrams/build.py` (`"tech/name.svg"`) and run `make diagrams`.
4. Animated logos (for example Floci's) do not work: they look incomplete as a static image.
