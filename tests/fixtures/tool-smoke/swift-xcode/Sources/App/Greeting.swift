// Declares the symbol ContentView.swift uses across the module (#4880).
struct Greeting {
	static func text() -> String {
		return "hello from another file"
	}
}
