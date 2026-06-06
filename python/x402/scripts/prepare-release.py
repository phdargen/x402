#!/usr/bin/env python3
"""Prepare a Python SDK release by bumping versions and building the changelog."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
PYPROJECT_VERSION_RE = re.compile(r'^version = "([^"]+)"$', re.MULTILINE)
INIT_VERSION_RE = re.compile(r'^__version__ = "([^"]+)"$', re.MULTILINE)
DEFAULT_REPOSITORY = "x402-foundation/x402"
REPOSITORY_URL = f"https://github.com/{DEFAULT_REPOSITORY}"

PR_COMMIT_AUTHORS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          commit {
            authors(first: 100) {
              nodes {
                user {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}
"""


class ReleasePrepError(RuntimeError):
    """Raised when the release-prep inputs or files are invalid."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare the Python SDK release version and Towncrier changelog."
    )
    version_group = parser.add_mutually_exclusive_group(required=True)
    version_group.add_argument("--version", help="Explicit release version, in X.Y.Z format.")
    version_group.add_argument(
        "--bump",
        choices=["minor", "patch"],
        help="Bump the current version. Scheduled releases use 'minor'.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the target version without modifying files.",
    )
    return parser.parse_args()


def package_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def require_file(path: Path) -> None:
    if not path.is_file():
        raise ReleasePrepError(f"Required file does not exist: {path}")


def require_directory(path: Path) -> None:
    if not path.is_dir():
        raise ReleasePrepError(f"Required directory does not exist: {path}")


def changelog_fragments(changelog_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in changelog_dir.iterdir()
        if path.is_file() and not path.name.startswith(".")
    )


def validate_version(version: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(version)
    if match is None:
        raise ReleasePrepError(f"Expected version in X.Y.Z format, got: {version}")
    return tuple(int(part) for part in match.groups())


def extract_single_version(path: Path, pattern: re.Pattern[str], label: str) -> str:
    content = path.read_text()
    matches = pattern.findall(content)
    if len(matches) != 1:
        raise ReleasePrepError(f"Expected exactly one {label} version in {path}, found {len(matches)}")
    validate_version(matches[0])
    return matches[0]


def bump_version(version: str, bump: str) -> str:
    major, minor, patch = validate_version(version)
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ReleasePrepError(f"Unsupported bump type: {bump}")


def assert_version_increases(current_version: str, target_version: str) -> None:
    if validate_version(target_version) <= validate_version(current_version):
        raise ReleasePrepError(
            f"Target version {target_version} must be greater than current version {current_version}"
        )


def replace_single(path: Path, pattern: re.Pattern[str], replacement: str, label: str) -> None:
    content = path.read_text()
    updated, count = pattern.subn(replacement, content)
    if count != 1:
        raise ReleasePrepError(f"Expected to update exactly one {label} version in {path}, updated {count}")
    path.write_text(updated)


def git_output(sdk_dir: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *command],
            cwd=sdk_dir,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    return completed.stdout.strip()


def gh_output(sdk_dir: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["gh", *command],
            cwd=sdk_dir,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    return completed.stdout.strip()


def fragment_issue(fragment: Path) -> str:
    return fragment.name.split(".", 1)[0]


def fragment_text(fragment: Path) -> str:
    return " ".join(fragment.read_text().split())


def repository_name() -> str:
    repository = os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPOSITORY)
    if "/" not in repository:
        return DEFAULT_REPOSITORY

    return repository


def fragment_commit_sha(sdk_dir: Path, fragment: Path) -> str | None:
    relative_fragment = fragment.relative_to(sdk_dir)
    output = git_output(
        sdk_dir,
        ["log", "-1", "--format=%H", "--", str(relative_fragment)],
    )
    if not output:
        return None

    return output


def add_unique(items: list[str], item: str | None) -> None:
    if item is not None and item not in items:
        items.append(item)


def pr_commit_author_logins(sdk_dir: Path, issue: str) -> list[str]:
    owner, name = repository_name().split("/", 1)
    logins: list[str] = []
    cursor = None

    while True:
        command = [
            "api",
            "graphql",
            "-f",
            f"query={PR_COMMIT_AUTHORS_QUERY}",
            "-F",
            f"owner={owner}",
            "-F",
            f"name={name}",
            "-F",
            f"number={issue}",
        ]
        if cursor is not None:
            command.extend(["-f", f"after={cursor}"])

        output = gh_output(sdk_dir, command)
        if not output:
            return logins

        try:
            data = json.loads(output)
            commits = data["data"]["repository"]["pullRequest"]["commits"]
        except (KeyError, TypeError, json.JSONDecodeError):
            return logins

        for node in commits["nodes"]:
            for author in node["commit"]["authors"]["nodes"]:
                user = author.get("user")
                if user is not None:
                    add_unique(logins, user.get("login"))

        if not commits["pageInfo"]["hasNextPage"]:
            return logins

        cursor = commits["pageInfo"]["endCursor"]


def thanks_text(logins: list[str]) -> str | None:
    if not logins:
        return None

    links = [f"[@{login}](https://github.com/{login})" for login in logins]
    if len(links) == 1:
        return f"Thanks {links[0]}!"

    if len(links) == 2:
        return f"Thanks {links[0]} and {links[1]}!"

    return f"Thanks {', '.join(links[:-1])}, and {links[-1]}!"


def fragment_preview_line(sdk_dir: Path, fragment: Path) -> str | None:
    issue = fragment_issue(fragment)
    text = fragment_text(fragment)
    if not issue.isdecimal() or not text:
        return None

    commit_sha = fragment_commit_sha(sdk_dir, fragment)
    logins = pr_commit_author_logins(sdk_dir, issue)
    parts = [f"- [#{issue}]({REPOSITORY_URL}/pull/{issue})"]

    if commit_sha is not None:
        short_sha = commit_sha[:7]
        parts.append(f"[`{short_sha}`]({REPOSITORY_URL}/commit/{commit_sha})")

    if (thanks := thanks_text(logins)) is not None:
        parts.append(thanks)

    return f"{' '.join(parts)} - {text}"


def changelog_fragment_preview(sdk_dir: Path, fragments: list[Path]) -> list[str]:
    return [
        line
        for fragment in fragments
        if (line := fragment_preview_line(sdk_dir, fragment)) is not None
    ]


def print_changelog_fragment_preview(lines: list[str]) -> None:
    if not lines:
        return

    print("Changelog fragment preview:")
    for line in lines:
        print(line)
    print()


def run_towncrier(sdk_dir: Path, version: str) -> None:
    try:
        subprocess.run(
            ["uv", "run", "towncrier", "build", "--yes", f"--version={version}"],
            cwd=sdk_dir,
            check=True,
        )
    except FileNotFoundError as exc:
        raise ReleasePrepError("uv is required to build the Towncrier changelog.") from exc
    except subprocess.CalledProcessError as exc:
        raise ReleasePrepError(f"Towncrier failed with exit code {exc.returncode}.") from exc


def main() -> int:
    args = parse_args()
    sdk_dir = package_dir()
    pyproject = sdk_dir / "pyproject.toml"
    init_file = sdk_dir / "__init__.py"
    changelog_dir = sdk_dir / "changelog.d"

    require_file(pyproject)
    require_file(init_file)
    require_directory(changelog_dir)

    fragments = changelog_fragments(changelog_dir)
    if not fragments:
        print("No changelog fragments found; release preparation skipped.")
        return 0

    current_version = extract_single_version(pyproject, PYPROJECT_VERSION_RE, "pyproject.toml")
    init_version = extract_single_version(init_file, INIT_VERSION_RE, "__init__.py")
    if init_version != current_version:
        raise ReleasePrepError(
            f"Version mismatch: pyproject.toml has {current_version}, __init__.py has {init_version}"
        )

    target_version = args.version if args.version is not None else bump_version(current_version, args.bump)
    validate_version(target_version)
    assert_version_increases(current_version, target_version)

    preview_lines = changelog_fragment_preview(sdk_dir, fragments)
    print_changelog_fragment_preview(preview_lines)

    if args.dry_run:
        print(f"Current Python SDK version: {current_version}")
        print(f"Target Python SDK version: {target_version}")
        print("Dry run complete; no files were changed.")
        return 0

    replace_single(
        pyproject,
        PYPROJECT_VERSION_RE,
        f'version = "{target_version}"',
        "pyproject.toml",
    )
    replace_single(
        init_file,
        INIT_VERSION_RE,
        f'__version__ = "{target_version}"',
        "__init__.py",
    )
    run_towncrier(sdk_dir, target_version)

    print(f"Prepared Python SDK release {target_version}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleasePrepError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
