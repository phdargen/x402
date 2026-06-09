#!/usr/bin/env python3
"""Prepare a TypeScript SDK release by consuming pending changesets.

Run from the repository root:

    python3 scripts/prepare-typescript-release.py
    python3 scripts/prepare-typescript-release.py --dry-run

Pending changesets live in ``typescript/.changeset/*.md``. This script enriches
their summaries with PR links and contributor attribution, then runs
``pnpm changeset version`` to bump package versions and update changelogs.
Use ``--dry-run`` to preview without modifying files.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_REPOSITORY = "x402-foundation/x402"
REPOSITORY_URL = f"https://github.com/{DEFAULT_REPOSITORY}"
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

PUBLISH_WORKFLOWS = [
    ("@x402/core", "Publish @x402/core package to NPM"),
    ("@x402/extensions", "Publish @x402/extensions package to NPM"),
    (
        "mechanisms",
        [
            ("@x402/evm", "Publish @x402/evm package to NPM"),
            ("@x402/svm", "Publish @x402/svm package to NPM"),
            ("@x402/avm", "Publish @x402/avm package to NPM"),
            ("@x402/aptos", "Publish @x402/aptos package to NPM"),
            ("@x402/stellar", "Publish @x402/stellar package to NPM"),
            ("@x402/hedera", "Publish @x402/hedera package to NPM"),
        ],
    ),
    ("@x402/paywall", "Publish @x402/paywall package to NPM"),
    (
        "http + mcp",
        [
            ("@x402/axios", "Publish @x402/axios package to NPM"),
            ("@x402/fetch", "Publish @x402/fetch package to NPM"),
            ("@x402/express", "Publish @x402/express package to NPM"),
            ("@x402/hono", "Publish @x402/hono package to NPM"),
            ("@x402/next", "Publish @x402/next package to NPM"),
            ("@x402/fastify", "Publish @x402/fastify package to NPM"),
            ("@x402/mcp", "Publish @x402/mcp package to NPM"),
        ],
    ),
]

PR_COMMIT_AUTHORS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author {
        login
      }
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
        description="Prepare the TypeScript SDK release by consuming pending changesets."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and preview changelog entries without modifying files.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def sdk_dir() -> Path:
    return repo_root() / "typescript"


def require_directory(path: Path) -> None:
    if not path.is_dir():
        raise ReleasePrepError(f"Required directory does not exist: {path}")


def changeset_files(changeset_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in changeset_dir.iterdir()
        if path.is_file() and path.suffix == ".md" and path.name != "README.md"
    )


def read_changeset(path: Path) -> tuple[str, str]:
    content = path.read_text()
    match = FRONTMATTER_RE.match(content)
    if match is None:
        raise ReleasePrepError(f"Could not parse changeset frontmatter: {path}")

    return match.group(1), content[match.end() :].strip()


def write_changeset(path: Path, frontmatter: str, body: str) -> None:
    path.write_text(f"---\n{frontmatter}\n---\n\n{body}\n")


def git_output(root: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *command],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    return completed.stdout.strip()


def gh_output(root: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["gh", *command],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    return completed.stdout.strip()


def repository_name() -> str:
    repository = os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPOSITORY)
    if "/" not in repository:
        return DEFAULT_REPOSITORY

    return repository


def fragment_commit_sha(root: Path, fragment: Path) -> str | None:
    relative_fragment = fragment.relative_to(root)
    output = git_output(
        root,
        ["log", "-1", "--format=%H", "--", str(relative_fragment)],
    )
    if not output:
        return None

    return output


def add_unique(items: list[str], item: str | None) -> None:
    if item is not None and item not in items:
        items.append(item)


def pr_authors(root: Path, issue: str) -> tuple[str | None, list[str]]:
    owner, name = repository_name().split("/", 1)
    pr_author: str | None = None
    commit_authors: list[str] = []
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

        output = gh_output(root, command)
        if not output:
            break

        try:
            data = json.loads(output)
            pull_request = data["data"]["repository"]["pullRequest"]
            commits = pull_request["commits"]
        except (KeyError, TypeError, json.JSONDecodeError):
            break

        if (author := pull_request.get("author")) is not None:
            pr_author = author.get("login")

        for node in commits["nodes"]:
            for commit_author in node["commit"]["authors"]["nodes"]:
                user = commit_author.get("user")
                if user is not None:
                    add_unique(commit_authors, user.get("login"))

        if not commits["pageInfo"]["hasNextPage"]:
            break

        cursor = commits["pageInfo"]["endCursor"]

    if pr_author is None and commit_authors:
        pr_author = commit_authors[0]

    contributors = [login for login in commit_authors if login != pr_author]
    return pr_author, contributors


def author_link(login: str) -> str:
    return f"[@{login}](https://github.com/{login})"


def thanks_text(pr_author: str | None, contributors: list[str]) -> str | None:
    if pr_author is None:
        return None

    text = author_link(pr_author)
    if contributors:
        text += " and " + ", ".join(author_link(login) for login in contributors)

    return f"Thanks {text}!"


def commit_author_login(root: Path, commit_sha: str) -> str | None:
    output = gh_output(
        root,
        ["api", f"repos/{repository_name()}/commits/{commit_sha}", "--jq", ".author.login"],
    )
    if not output or output == "null":
        return None

    return output


def commit_pr_number(root: Path, commit_sha: str) -> str | None:
    output = gh_output(
        root,
        ["api", f"repos/{repository_name()}/commits/{commit_sha}/pulls", "--jq", ".[0].number"],
    )
    if not output or output == "null":
        return None

    return output


def fragment_thanks(root: Path, pr_number: str | None, commit_sha: str | None) -> str | None:
    pr_author: str | None = None
    contributors: list[str] = []

    if pr_number is not None:
        pr_author, contributors = pr_authors(root, pr_number)

    if pr_author is None and commit_sha is not None:
        pr_author = commit_author_login(root, commit_sha)

    return thanks_text(pr_author, contributors)


def changeset_changelog_body(root: Path, changeset: Path, body: str) -> str | None:
    text = " ".join(body.split())
    if not text:
        return None

    commit_sha = fragment_commit_sha(root, changeset)
    pr_number = commit_pr_number(root, commit_sha) if commit_sha is not None else None

    rendered = text
    if pr_number is not None:
        rendered += f" ([#{pr_number}]({REPOSITORY_URL}/pull/{pr_number}))"

    if (thanks := fragment_thanks(root, pr_number, commit_sha)) is not None:
        rendered += f" - {thanks}"

    return rendered


def changeset_bodies(root: Path, changesets: list[Path]) -> list[tuple[Path, str, str]]:
    bodies: list[tuple[Path, str, str]] = []
    for changeset in changesets:
        frontmatter, body = read_changeset(changeset)
        rendered = changeset_changelog_body(root, changeset, body)
        if rendered is not None:
            bodies.append((changeset, frontmatter, rendered))
    return bodies


def print_changeset_preview(bodies: list[tuple[Path, str, str]]) -> None:
    if not bodies:
        return

    print("Changeset preview:")
    for changeset, _, body in bodies:
        print(f"- {changeset.name}: {body}")
    print()


def rewrite_changesets(root: Path, bodies: list[tuple[Path, str, str]]) -> None:
    for changeset, frontmatter, body in bodies:
        write_changeset(changeset, frontmatter, body)
        git_output(root, ["add", "--", str(changeset.relative_to(root))])


def read_core_version(root: Path) -> str:
    package_json = root / "packages" / "core" / "package.json"
    if not package_json.is_file():
        raise ReleasePrepError(f"Required file does not exist: {package_json}")

    try:
        version = json.loads(package_json.read_text())["version"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ReleasePrepError(f"Could not read version from {package_json}") from exc

    return version


def run_changeset_version(root: Path) -> None:
    try:
        subprocess.run(["pnpm", "changeset", "version"], cwd=root, check=True)
    except FileNotFoundError as exc:
        raise ReleasePrepError(
            "pnpm is required to version packages. Install pnpm and run: cd typescript && pnpm install"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise ReleasePrepError(f"pnpm changeset version failed with exit code {exc.returncode}.") from exc


def print_post_release_steps(version: str) -> None:
    print("Post-release steps:")
    print("1. Merge the release PR into main.")
    print("2. In GitHub Actions, run each publish workflow in order:")
    for entry in PUBLISH_WORKFLOWS:
        if isinstance(entry[1], str):
            print(f"   - {entry[1]}")
            continue

        print(f"   - {entry[0]}:")
        for _, workflow in entry[1]:
            print(f"     - {workflow}")
    print(f"3. Confirm @x402/core and dependents published at version {version} on npm.")


def main() -> int:
    args = parse_args()
    root = sdk_dir()
    changeset_dir = root / ".changeset"

    require_directory(changeset_dir)

    changesets = changeset_files(changeset_dir)
    if not changesets:
        print("No pending changesets found; release preparation skipped.")
        return 0

    current_version = read_core_version(root)
    changeset_bodies_list = changeset_bodies(root, changesets)
    print_changeset_preview(changeset_bodies_list)

    if args.dry_run:
        print(f"Current @x402/core version: {current_version}")
        print(f"Pending changesets: {len(changesets)}")
        print("Dry run complete; no files were changed.")
        return 0

    rewrite_changesets(root, changeset_bodies_list)
    run_changeset_version(root)
    target_version = read_core_version(root)

    print(f"Prepared TypeScript SDK release (@x402/core {current_version} -> {target_version})")
    print_post_release_steps(target_version)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleasePrepError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
