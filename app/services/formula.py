"""
The formula of a calculated widget (2.6.0): parsing and evaluation.

A calculated widget (``MetricQuery.formula``) combines named terms -- each a
summed or counted measure with its own filters -- with a small arithmetic
language::

    expression := sum
    sum        := product (("+" | "-") product)*
    product    := unary (("*" | "/") unary)*
    unary      := "-" unary | primary
    primary    := number ["%"] | name | "(" sum ")"
    number     := digits ["." digits] | "." digits
    name       := [a-z][a-z0-9_]*

``70%`` is 0.7; a decimal comma is refused with a message saying to use a
point. The parser is hand-written recursive descent into a small tree, with
a nesting limit (``MAX_DEPTH``); nothing is ever ``eval``-ed.

**Mirror contract**: ``frontend/src/utils/formula.ts`` parses the same
language with the same messages (the editor validates as the user types);
``FORMULA_CASES`` in ``tests/test_formula.py`` and
``src/utils/__tests__/formula.test.ts`` are the shared table -- change one,
change both. Evaluation is server-only (``evaluate``).

The canonical form (``canonical``) brackets every operation and keeps each
number as written: ``a/(b*70%)`` -> ``(a / (b * 70%))``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

MAX_FORMULA_LENGTH = 200
# Brackets and unary minus, nested.
MAX_DEPTH = 20

EMPTY_DETAIL = "Enter a formula"
TOO_LONG_DETAIL = f"A formula has at most {MAX_FORMULA_LENGTH} characters"
DECIMAL_COMMA_DETAIL = "Use a point for decimals (0.7, not 0,7)"
TOO_DEEP_DETAIL = "The formula is nested too deeply"
ENDS_EARLY_DETAIL = "The formula ends too early"
UNCLOSED_DETAIL = 'A "(" is not closed'


class FormulaError(ValueError):
    """A formula that cannot be read; ``message`` is in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Node:
    """
    A formula tree node: ``kind`` is ``num`` (``value``, ``text`` as written),
    ``name`` (``text``), ``neg`` (``left``) or one of ``+ - * /``
    (``left``, ``right``).
    """

    kind: str
    value: float = 0.0
    text: str = ""
    left: Node | None = None
    right: Node | None = None


@dataclass(frozen=True)
class Formula:
    tree: Node
    # Every term name the formula uses, in order of first appearance.
    names: tuple[str, ...]
    canonical: str


class _Token:
    __slots__ = ("kind", "text", "pos")

    def __init__(self, kind: str, text: str, pos: int):
        self.kind = kind  # "num", "name", "op", "end"
        self.text = text
        self.pos = pos  # 1-based position of its first character


def _unexpected(text: str, pos: int) -> FormulaError:
    return FormulaError(f'Unexpected "{text}" at position {pos}')


def _tokens(source: str) -> list[_Token]:
    out: list[_Token] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch in " \t":
            i += 1
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and source[i + 1].isdigit()):
            start = i
            while i < n and source[i].isdigit():
                i += 1
            if i < n and source[i] == ".":
                i += 1
                if i >= n or not source[i].isdigit():
                    raise _unexpected(".", i)
                while i < n and source[i].isdigit():
                    i += 1
            if i < n and source[i] == "," and i + 1 < n and source[i + 1].isdigit():
                raise FormulaError(DECIMAL_COMMA_DETAIL)
            out.append(_Token("num", source[start:i], start + 1))
            continue
        if "a" <= ch <= "z":
            start = i
            while i < n and ("a" <= source[i] <= "z" or source[i].isdigit() or source[i] == "_"):
                i += 1
            if i < n and "A" <= source[i] <= "Z":
                raise FormulaError(f"Term names are written in lowercase, at position {i + 1}")
            out.append(_Token("name", source[start:i], start + 1))
            continue
        if "A" <= ch <= "Z":
            raise FormulaError(f"Term names are written in lowercase, at position {i + 1}")
        if ch in "+-*/()%":
            out.append(_Token("op", ch, i + 1))
            i += 1
            continue
        raise _unexpected(ch, i + 1)
    out.append(_Token("end", "", n + 1))
    return out


class _Parser:
    def __init__(self, tokens: list[_Token]):
        self.tokens = tokens
        self.index = 0
        self.depth = 0

    def peek(self) -> _Token:
        return self.tokens[self.index]

    def take(self) -> _Token:
        token = self.tokens[self.index]
        self.index += 1
        return token

    def enter(self) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise FormulaError(TOO_DEEP_DETAIL)

    def sum(self) -> Node:
        node = self.product()
        while self.peek().kind == "op" and self.peek().text in "+-":
            op = self.take().text
            node = Node(op, left=node, right=self.product())
        return node

    def product(self) -> Node:
        node = self.unary()
        while self.peek().kind == "op" and self.peek().text in "*/":
            op = self.take().text
            node = Node(op, left=node, right=self.unary())
        return node

    def unary(self) -> Node:
        token = self.peek()
        if token.kind == "op" and token.text == "-":
            self.take()
            self.enter()
            node = Node("neg", left=self.unary())
            self.depth -= 1
            return node
        return self.primary()

    def primary(self) -> Node:
        token = self.take()
        if token.kind == "num":
            value = float(token.text)
            text = token.text
            if self.peek().kind == "op" and self.peek().text == "%":
                self.take()
                value /= 100
                text += "%"
            return Node("num", value=value, text=text)
        if token.kind == "name":
            return Node("name", text=token.text)
        if token.kind == "op" and token.text == "(":
            self.enter()
            node = self.sum()
            self.depth -= 1
            closing = self.take()
            if closing.kind == "end":
                raise FormulaError(UNCLOSED_DETAIL)
            if closing.text != ")":
                raise _unexpected(closing.text, closing.pos)
            return node
        if token.kind == "end":
            raise FormulaError(ENDS_EARLY_DETAIL)
        raise _unexpected(token.text, token.pos)


def canonical(node: Node) -> str:
    """Every operation bracketed, numbers as written: ``(a / (b * 70%))``."""
    if node.kind == "num" or node.kind == "name":
        return node.text
    assert node.left is not None
    if node.kind == "neg":
        return f"(-{canonical(node.left)})"
    assert node.right is not None
    return f"({canonical(node.left)} {node.kind} {canonical(node.right)})"


def _names(node: Node, out: list[str]) -> None:
    if node.kind == "name":
        if node.text not in out:
            out.append(node.text)
        return
    if node.left is not None:
        _names(node.left, out)
    if node.right is not None:
        _names(node.right, out)


def parse(source: str) -> Formula:
    """The formula ``source`` as a tree, or ``FormulaError`` in plain words."""
    if len(source) > MAX_FORMULA_LENGTH:
        raise FormulaError(TOO_LONG_DETAIL)
    if not source.strip():
        raise FormulaError(EMPTY_DETAIL)
    parser = _Parser(_tokens(source))
    tree = parser.sum()
    token = parser.peek()
    if token.kind != "end":
        raise _unexpected(token.text, token.pos)
    names: list[str] = []
    _names(tree, names)
    return Formula(tree=tree, names=tuple(names), canonical=canonical(tree))


def divide(num: float | None, den: float | None) -> float | None:
    """
    ``num / den``: empty when either is empty, or when ``den`` is 0 and
    ``num`` is not (booked time over no capacity has no ratio); 0 when both
    are 0 (an empty bucket).
    """
    if num is None or den is None:
        return None
    if den == 0:
        return 0.0 if num == 0 else None
    return num / den


def evaluate(node: Node, values: Mapping[str, float | None]) -> float | None:
    """
    ``node`` over the terms' ``values``: an empty value propagates, division
    follows ``divide``, a non-finite result is empty.
    """
    result = _evaluate(node, values)
    if result is None or not math.isfinite(result):
        return None
    return result


def _evaluate(node: Node, values: Mapping[str, float | None]) -> float | None:
    if node.kind == "num":
        return node.value
    if node.kind == "name":
        return values.get(node.text)
    assert node.left is not None
    left = _evaluate(node.left, values)
    if node.kind == "neg":
        return None if left is None else -left
    assert node.right is not None
    right = _evaluate(node.right, values)
    if left is None or right is None:
        return None
    if node.kind == "+":
        return left + right
    if node.kind == "-":
        return left - right
    if node.kind == "*":
        return left * right
    return divide(left, right)
