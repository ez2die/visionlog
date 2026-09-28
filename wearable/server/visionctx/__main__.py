import argparse
import logging

import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    s = Settings()
    p = argparse.ArgumentParser(prog="visionctx", description="VisionCtx demo server")
    p.add_argument("--host", default=s.host)
    p.add_argument("--port", type=int, default=s.port)
    p.add_argument("--data", default=str(s.data_dir), help="data directory")
    p.add_argument("--no-mdns", action="store_true")
    a = p.parse_args()
    s.host, s.port, s.mdns = a.host, a.port, s.mdns and not a.no_mdns
    s.data_dir = type(s.data_dir)(a.data)
    s.data_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    uvicorn.run(create_app(s), host=s.host, port=s.port, ws_max_size=4 * 1024 * 1024)


if __name__ == "__main__":
    main()
