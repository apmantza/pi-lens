package main

import "fmt"

// Tool-smoke fixture for #209 — go vet flags the %d verb applied to a string.
func main() {
	fmt.Printf("%d\n", "not a number")
}
