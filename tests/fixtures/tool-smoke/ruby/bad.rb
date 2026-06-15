# frozen_string_literal: true

# Tool-smoke fixture for #209 — rubocop flags the useless assignment.
def greet
  x = 'unused'
  puts 'hello'
end
