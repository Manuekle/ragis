# AWS Emulator (https://github.com/aws/aws-emulator): official local emulator of the AWS APIs.
# AWS publishes no prebuilt image for macOS/Windows; this is the Dockerfile from the user guide
# ("Getting started with Docker"), with the package picked from the build architecture.
# Built and started by scripts/aws-emulator.sh. See docs/guides/aws-emulator.md.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG TARGETARCH
# LTS channel; pin a version by replacing "latest" (for example LTS/1.0.322) if a release breaks the rehearsal.
ARG EMULATOR_CHANNEL=LTS/latest
RUN set -eu; \
    case "${TARGETARCH:-$(uname -m)}" in \
      arm64|aarch64) pkg=aws-emulator-aarch64.rpm ;; \
      *)             pkg=aws-emulator-x86_64.rpm ;; \
    esac; \
    curl -fsSL -o /tmp/aws-emulator.rpm "https://downloads.aws.com/aws-emulator/packages/aws-emulator/${EMULATOR_CHANNEL}/${pkg}"; \
    rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm; \
    mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
