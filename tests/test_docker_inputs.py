"""The production image and the CI path filters must carry shared/.

shared/permission-keys.json is written by the backend catalogue test and
imported by the Vitest mirror test, which `npm run build` (tsc -b) type-checks.
The Docker frontend stage therefore needs it next to frontend/, and a change to
it must re-run the backend, frontend and docker workflows.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "Dockerfile"
WORKFLOWS = ROOT / ".github" / "workflows"
IN_REPO = DOCKERFILE.exists() and WORKFLOWS.exists()

pytestmark = pytest.mark.skipif(
    not IN_REPO, reason="needs the repository checkout (Dockerfile, .github)"
)


def _frontend_stage() -> list[str]:
    """Lines of the `frontend` build stage, up to the next FROM."""
    lines = DOCKERFILE.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if re.match(r"FROM .* AS frontend\b", line))
    stage: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("FROM "):
            break
        stage.append(line.strip())
    return stage


def test_frontend_stage_copies_shared_beside_frontend() -> None:
    stage = _frontend_stage()
    workdirs = [line.split()[1] for line in stage if line.startswith("WORKDIR ")]
    assert workdirs == ["/build/frontend"]
    # The mirror test imports ../../../../shared/ from frontend/src/utils/__tests__.
    assert "COPY shared/ /build/shared/" in stage
    build = stage.index("RUN npm run build")
    assert stage.index("COPY shared/ /build/shared/") < build


def test_runtime_copies_the_frontend_build_output() -> None:
    assert "COPY --from=frontend /build/frontend/dist/ ./public/" in DOCKERFILE.read_text()


def test_dockerignore_keeps_shared() -> None:
    ignored = [
        line.strip()
        for line in (ROOT / ".dockerignore").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert not any(entry.startswith("shared") for entry in ignored)


@pytest.mark.parametrize("workflow", ["docker.yml", "frontend.yml", "backend.yml"])
def test_workflow_path_filter_includes_shared(workflow: str) -> None:
    text = (WORKFLOWS / workflow).read_text()
    assert "- 'shared/**'" in text
