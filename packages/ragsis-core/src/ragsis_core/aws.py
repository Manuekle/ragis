from __future__ import annotations

from functools import lru_cache

import boto3
from botocore.config import Config

from .settings import get_settings


@lru_cache
def s3_client():
    s = get_settings()
    return boto3.client(
        "s3",
        region_name=s.aws_region,
        endpoint_url=s.s3_endpoint or None,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"mode": "standard"}),
    )


@lru_cache
def sqs_client():
    s = get_settings()
    return boto3.client(
        "sqs",
        region_name=s.aws_region,
        endpoint_url=s.sqs_endpoint or None,
        config=Config(retries={"mode": "standard"}),
    )
