"""E2E contra el stack levantado (make up): provisiona, ingesta y evalúa con metas obligatorias."""
import sys

from ragsis_eval.run import main

if __name__ == "__main__":
    sys.argv = [sys.argv[0], "--assert", *sys.argv[1:]]
    main()
