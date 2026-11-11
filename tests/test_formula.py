"""
The formula language of calculated widgets (app/services/formula.py).

``FORMULA_CASES`` is the mirror contract with ``frontend/src/utils/formula.ts``:
the same table, case for case, is asserted in
``frontend/src/utils/__tests__/formula.test.ts`` -- change one, change both
(the length pin below and there keeps them the same size). Each case is
``(expression, canonical form, names)`` or ``(expression, None, error)``.
Evaluation is server-only and tested here alone.
"""

import math

import pytest

from app.services.formula import (
    MAX_DEPTH,
    MAX_FORMULA_LENGTH,
    FormulaError,
    divide,
    evaluate,
    parse,
)

FORMULA_CASES: list[tuple[str, str | None, tuple[str, ...] | str]] = [
    (
        "customer_weeks / (capacity_weeks * 70%)",
        "(customer_weeks / (capacity_weeks * 70%))",
        ("customer_weeks", "capacity_weeks"),
    ),
    ("a+b*c", "(a + (b * c))", ("a", "b", "c")),
    ("(a+b)*c", "((a + b) * c)", ("a", "b", "c")),
    ("a - b - c", "((a - b) - c)", ("a", "b", "c")),
    ("a / b / c", "((a / b) / c)", ("a", "b", "c")),
    ("-a - -b", "((-a) - (-b))", ("a", "b")),
    ("(a)", "a", ("a",)),
    ("a * a + b", "((a * a) + b)", ("a", "b")),
    ("1 - a / b", "(1 - (a / b))", ("a", "b")),
    (".5*a", "(.5 * a)", ("a",)),
    ("2.25 * x_1", "(2.25 * x_1)", ("x_1",)),
    ("100%", "100%", ()),
    ("  a\t+ b ", "(a + b)", ("a", "b")),
    ("", None, "Enter a formula"),
    ("   ", None, "Enter a formula"),
    ("x" * (MAX_FORMULA_LENGTH + 1), None, "A formula has at most 200 characters"),
    ("a * 0,7", None, "Use a point for decimals: 0.7"),
    ("a , b", None, 'Unexpected "," at position 3'),
    ("a +", None, "The formula ends too early: something is missing at the end"),
    ("(a", None, "Missing closing bracket )"),
    ("a)", None, 'Unexpected ")" at position 2'),
    ("a b", None, 'Unexpected "b" at position 3'),
    ("1.", None, 'Unexpected "." at position 2'),
    ("1..2", None, 'Unexpected "." at position 2'),
    ("a $ b", None, 'Unexpected "$" at position 3'),
    ("% a", None, 'Unexpected "%" at position 1'),
    ("A / B", "(a / b)", ("a", "b")),
    (
        "Customer_Weeks ÷ (Capacity × 70%)",
        "(customer_weeks / (capacity * 70%))",
        ("customer_weeks", "capacity"),
    ),
    ("(" * (MAX_DEPTH + 1) + "a" + ")" * (MAX_DEPTH + 1), None, "The formula is nested too deeply"),
    ("-" * (MAX_DEPTH + 1) + "a", None, "The formula is nested too deeply"),
]


def test_the_mirror_table_has_its_pinned_length():
    # The frontend table pins the same number (formula.test.ts).
    assert len(FORMULA_CASES) == 30


@pytest.mark.parametrize(("source", "canonical", "expected"), FORMULA_CASES)
def test_formula_cases(source, canonical, expected):
    if canonical is None:
        with pytest.raises(FormulaError) as caught:
            parse(source)
        assert caught.value.message == expected
    else:
        formula = parse(source)
        assert formula.canonical == canonical
        assert formula.names == expected


def values_of(source: str, **values: float | None) -> float | None:
    return evaluate(parse(source).tree, values)


def test_arithmetic_and_precedence():
    assert values_of("a + b * c", a=1, b=2, c=3) == 7
    assert values_of("(a + b) * c", a=1, b=2, c=3) == 9
    assert values_of("a - b - c", a=10, b=3, c=2) == 5
    assert values_of("-a * 2", a=3) == -6
    assert values_of("a / (b * 70%)", a=7, b=10) == pytest.approx(1.0)
    assert values_of("50% + .5") == 1.0


def test_an_empty_value_propagates():
    assert values_of("a + b", a=None, b=1) is None
    assert values_of("-a", a=None) is None
    assert values_of("a * 0", a=None) is None
    # A term the values do not name is empty too.
    assert values_of("a + b", a=1) is None


def test_division_by_zero():
    assert values_of("a / b", a=0, b=0) == 0
    assert values_of("a / b", a=5, b=0) is None
    # A negative numerator over 0 is empty too (ratio_percent read it as 0).
    assert values_of("a / b", a=-5, b=0) is None
    assert divide(None, 1) is None
    assert divide(1, None) is None
    assert divide(3, 4) == 0.75


def test_a_non_finite_result_is_empty():
    huge = "9" * 95
    assert values_of(f"{huge} * {huge} * a", a=1e200) is None
    assert values_of("a * a", a=1e308) is None
    assert math.isfinite(values_of("a * a", a=1e10))  # type: ignore[arg-type]


def test_formula_error_carries_its_message():
    error = FormulaError("x")
    assert error.message == "x" and str(error) == "x"


def test_plain_word_details_for_the_terms():
    from app.services.formula import unknown_name_detail, unused_term_detail

    assert unknown_name_detail("capcity", ["a", "b"]) == '"capcity" is not one of your terms: a, b'
    assert unused_term_detail("c") == "Term c is not used in the formula: use it or remove it"
