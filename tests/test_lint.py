"""Tests for code quality — ruff lint and format checks."""

import subprocess

import pytest


@pytest.fixture(scope="module")
def project_root():
    """Get project root directory."""
    import pathlib
    return str(pathlib.Path(__file__).parent.parent)


def test_ruff_check(project_root):
    """Backend code passes ruff lint checks."""
    result = subprocess.run(
        ["ruff", "check", "app/"],
        cwd=project_root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"ruff check failed:\n{result.stdout}\n{result.stderr}"


def test_ruff_format(project_root):
    """Backend code is properly formatted per ruff."""
    result = subprocess.run(
        ["ruff", "format", "--check", "app/"],
        cwd=project_root,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"ruff format check failed:\n{result.stdout}\n{result.stderr}"
