"""Tests for builder-code resource server declaration."""

import pytest

from x402.extensions.builder_code import (
    BUILDER_CODE_SCHEMA,
    declare_builder_code_extension,
)


class TestDeclareBuilderCodeExtension:
    def test_declares_info_and_schema(self) -> None:
        declaration = declare_builder_code_extension("bc_my_service")
        assert declaration == {
            "info": {"a": "bc_my_service"},
            "schema": BUILDER_CODE_SCHEMA,
        }

    def test_rejects_uppercase(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("INVALID")

    def test_rejects_hyphen(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("bad-code")

    def test_rejects_too_long(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("a" * 33)

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("")
