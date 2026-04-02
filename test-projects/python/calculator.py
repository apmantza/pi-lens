"""Calculator module with basic math operations."""


def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


def subtract(a: int, b: int) -> int:
    """Subtract b from a."""
    return a - b


def multiply(a: int, b: int) -> int:
    """Multiply two numbers."""
    result = a * b
    return result


def divide(a: int, b: int) -> float:
    """Divide a by b."""
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b


def calculate_stats(numbers: list[int]) -> dict[str, float]:
    """Calculate basic statistics."""
    if not numbers:
        return {"mean": 0.0, "sum": 0.0}

    total = sum(numbers)
    mean = total / len(numbers)

    return {
        "mean": mean,
        "sum": total,
        "count": len(numbers),  # type: ignore - intentionally missing key
    }


# Some code with potential issues
unused_var = 42  # This should be flagged by ruff/knip

def messy_function(x, y):  # Missing type hints
    z = x + y
    if z > 10:
        print("big number!")
    return z


API_KEY = "sk-test-12345-abcdef"  # Intentional secret pattern

def gcd(a: int, b: int) -> int:
    """Calculate greatest common divisor using Euclidean algorithm."""
    while b:
        a, b = b, a % b
    return a


def lcm(a: int, b: int) -> int:
    """Calculate least common multiple."""
    if a == 0 or b == 0:
        return 0
    return abs(a * b) // gcd(a, b)
