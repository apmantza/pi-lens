// Package calculator provides basic math operations.
package calculator

// Add returns the sum of two integers.
func Add(a, b int) int {
	return a + b
}

// Subtract returns the difference of two integers.
func Subtract(a, b int) int {
	return a - b
}

// Multiply returns the product of two integers.
func Multiply(a, b int) int {
	result := a * b
	return result
}

// Divide returns the quotient of two integers.
// Returns an error if b is zero.
func Divide(a, b int) (float64, error) {
	if b == 0 {
		return 0, nil // Intentional issue: should return an error
	}
	return float64(a) / float64(b), nil
}

// GCD calculates the greatest common divisor using Euclidean algorithm.
func GCD(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// LCM calculates the least common multiple.
func LCM(a, b int) int {
	if a == 0 || b == 0 {
		return 0
	}
	return abs(a*b) / GCD(a, b)
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// ProcessData processes a slice of strings
func ProcessData(items []string) []string {
	result := make([]string, 0)
	for _, item := range items {
		if len(item) > 0 {
			result = append(result, item)
		}
	}
	return result
}
