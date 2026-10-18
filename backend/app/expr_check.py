"""Syntax check for the lesson expression language (see src/lesson/expr.ts).

Only parses; never evaluates. Used to catch broken expressions in generated
lessons so they can be sent back to the model for repair.
"""

from __future__ import annotations

import re
from typing import Any

_TOKEN = re.compile(
    r"\s*(?:"
    r"(?P<num>\d*\.?\d+(?:[eE][+-]?\d+)?)"
    r"|(?P<str>'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
    r"|(?P<id>[A-Za-z_$][\w$]*)"
    r"|(?P<op>===|!==|==|!=|<=|>=|&&|\|\||\*\*|[-+*/%^!<>?:(),.\[\]])"
    r")"
)
_FORBIDDEN = {"__proto__", "prototype", "constructor"}


class ExprError(ValueError):
    pass


def _tokenize(src: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    src = src.rstrip()
    while pos < len(src):
        m = _TOKEN.match(src, pos)
        if not m or m.end() == pos:
            raise ExprError(f"unexpected character {src[pos]!r} at {pos}")
        kind = m.lastgroup or ""
        out.append((kind, m.group(kind)))
        pos = m.end()
    return out


class _Parser:
    def __init__(self, toks: list[tuple[str, str]]):
        self.t = toks
        self.p = 0

    def is_op(self, *vals: str) -> bool:
        return self.p < len(self.t) and self.t[self.p][0] == "op" and self.t[self.p][1] in vals

    def expect(self, v: str) -> None:
        if not self.is_op(v):
            got = self.t[self.p][1] if self.p < len(self.t) else "end"
            raise ExprError(f"expected {v!r}, got {got!r}")
        self.p += 1

    def parse(self) -> None:
        self.ternary()
        if self.p < len(self.t):
            raise ExprError(f"unexpected {self.t[self.p][1]!r}")

    def ternary(self) -> None:
        self.binary(0)
        if self.is_op("?"):
            self.p += 1
            self.ternary()
            self.expect(":")
            self.ternary()

    LEVELS = [("||",), ("&&",), ("==", "!=", "===", "!=="), ("<", ">", "<=", ">="), ("+", "-"), ("*", "/", "%")]

    def binary(self, level: int) -> None:
        if level == len(self.LEVELS):
            self.unary()
            return
        self.binary(level + 1)
        while self.is_op(*self.LEVELS[level]):
            self.p += 1
            self.binary(level + 1)

    def unary(self) -> None:
        if self.is_op("-", "+", "!"):
            self.p += 1
            self.unary()
            return
        self.postfix()
        if self.is_op("^", "**"):
            self.p += 1
            self.unary()

    def postfix(self) -> None:
        self.primary()
        while True:
            if self.is_op("."):
                self.p += 1
                if self.p >= len(self.t) or self.t[self.p][0] != "id":
                    raise ExprError("expected a name after '.'")
                if self.t[self.p][1] in _FORBIDDEN:
                    raise ExprError(f"{self.t[self.p][1]!r} is not allowed")
                self.p += 1
            elif self.is_op("["):
                self.p += 1
                self.ternary()
                self.expect("]")
            elif self.is_op("("):
                self.p += 1
                if not self.is_op(")"):
                    self.ternary()
                    while self.is_op(","):
                        self.p += 1
                        self.ternary()
                self.expect(")")
            else:
                return

    def primary(self) -> None:
        if self.p >= len(self.t):
            raise ExprError("unexpected end of expression")
        kind, val = self.t[self.p]
        self.p += 1
        if kind in ("num", "str"):
            return
        if kind == "id":
            if val in _FORBIDDEN:
                raise ExprError(f"{val!r} is not allowed")
            return
        if val == "(":
            self.ternary()
            self.expect(")")
            return
        raise ExprError(f"unexpected {val!r}")


def check_expr(src: str) -> str | None:
    """Return an error message, or None if the expression parses."""
    try:
        _Parser(_tokenize(src)).parse()
        return None
    except ExprError as e:
        return str(e)


_EXPR_KEYS = {"$", "expr", "when", "pass", "warn"}
_TEMPLATE_KEYS = {"text", "resultLabel"}


def find_expression_errors(lesson: dict[str, Any], limit: int = 25) -> list[str]:
    """Walk raw lesson JSON and report expressions that don't parse."""
    errors: list[str] = []

    def visit(node: Any, path: str, in_rules: bool = False) -> None:
        if len(errors) >= limit:
            return
        if isinstance(node, dict):
            for k, v in node.items():
                here = f"{path}.{k}"
                if isinstance(v, str):
                    if k in _EXPR_KEYS or (k == "value" and "kind" in node):
                        if err := check_expr(v):
                            errors.append(f"{here}: {err} in {v!r}")
                    elif k in _TEMPLATE_KEYS and in_rules or k == "resultLabel":
                        for ex in re.findall(r"\{([^{}]+)\}", v):
                            if err := check_expr(ex):
                                errors.append(f"{here}: {err} in placeholder {{{ex}}}")
                elif k == "vars" and isinstance(v, dict):
                    for name, ex in v.items():
                        if not isinstance(ex, str) or (err := check_expr(ex)):
                            errors.append(f"{here}.{name}: {err if isinstance(ex, str) else 'must be a string expression'}")
                else:
                    visit(v, here, in_rules or k == "rules")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                visit(v, f"{path}[{i}]", in_rules)

    visit(lesson, "lesson")
    return errors
